/**
 * Ticket repository contract.
 *
 * Exported as a plain function (not a `*.test.ts` file) so it can be invoked
 * against every adapter. See `ticket-repository.contract.test.ts` for the
 * in-memory run; a Prisma run can be gated by an env flag once a test DB is
 * available.
 */

import { describe, expect, it, beforeEach } from 'vitest';
import type { Repos, UnitOfWork } from '@/data/ports/unit-of-work';
import type { User } from '@/domain/types';

export interface ContractContext {
  repos: Repos;
  uow: UnitOfWork;
  /** Seeds a small fixture: 1 requester, 2 agents, 1 category. Returns their ids. */
  seedBasicFixture: () => Promise<{
    requester: User;
    agentA: User;
    agentB: User;
    categoryId: string;
  }>;
}

export function runTicketRepositoryContract(
  makeContext: () => ContractContext | Promise<ContractContext>,
) {
  describe('TicketRepository contract', () => {
    let ctx: ContractContext;

    beforeEach(async () => {
      ctx = await makeContext();
    });

    it('create + findById round-trips', async () => {
      const { requester, categoryId } = await ctx.seedBasicFixture();
      const created = await ctx.repos.tickets.create({
        title: 'ログインできません',
        body: 'パスワードを入れてもはじかれる',
        priority: 'High',
        creatorId: requester.id,
        categoryId,
      });
      expect(created.status).toBe('New');
      expect(created.creator.id).toBe(requester.id);

      const found = await ctx.repos.tickets.findById(created.id);
      expect(found?.title).toBe('ログインできません');
      expect(found?.priority).toBe('High');
    });

    it('list applies creatorId filter and returns most-recent first', async () => {
      const { requester, agentA, categoryId } = await ctx.seedBasicFixture();
      const t1 = await ctx.repos.tickets.create({
        title: 'Older',
        body: 'x',
        priority: 'Low',
        creatorId: requester.id,
        categoryId,
      });
      // Force distinct timestamps in the memory adapter
      await new Promise((r) => setTimeout(r, 2));
      const t2 = await ctx.repos.tickets.create({
        title: 'Newer',
        body: 'y',
        priority: 'Medium',
        creatorId: agentA.id,
        categoryId,
      });

      const requesterOnly = await ctx.repos.tickets.list({
        filter: { creatorId: requester.id },
        page: { skip: 0, take: 50 },
      });
      expect(requesterOnly.map((t) => t.id)).toEqual([t1.id]);

      const all = await ctx.repos.tickets.list({
        filter: {},
        page: { skip: 0, take: 50 },
      });
      expect(all.map((t) => t.id)).toEqual([t2.id, t1.id]);
    });

    it('list with caseInsensitive text search matches title and body across cases', async () => {
      const { requester, categoryId } = await ctx.seedBasicFixture();
      await ctx.repos.tickets.create({
        title: 'VPN がつながらない',
        body: 'Yamada',
        priority: 'Medium',
        creatorId: requester.id,
        categoryId,
      });
      await ctx.repos.tickets.create({
        title: 'プリンタ不調',
        body: 'vpn 関連では無さそう',
        priority: 'Low',
        creatorId: requester.id,
        categoryId,
      });
      await ctx.repos.tickets.create({
        title: '経費申請',
        body: '無関係',
        priority: 'Low',
        creatorId: requester.id,
        categoryId,
      });

      const result = await ctx.repos.tickets.list({
        filter: { text: { contains: 'VPN', caseInsensitive: true } },
        page: { skip: 0, take: 50 },
      });
      expect(result).toHaveLength(2);

      const countResult = await ctx.repos.tickets.count({
        text: { contains: 'VPN', caseInsensitive: true },
      });
      expect(countResult).toBe(2);
    });

    it('list with assigneeId "unassigned" returns only null assignees', async () => {
      const { requester, agentA, categoryId } = await ctx.seedBasicFixture();
      const assigned = await ctx.repos.tickets.create({
        title: 'A',
        body: 'a',
        priority: 'Low',
        creatorId: requester.id,
        categoryId,
      });
      await ctx.repos.tickets.updateAssignee(assigned.id, agentA.id);
      const unassigned = await ctx.repos.tickets.create({
        title: 'B',
        body: 'b',
        priority: 'Low',
        creatorId: requester.id,
        categoryId,
      });

      const result = await ctx.repos.tickets.list({
        filter: { assigneeId: 'unassigned' },
        page: { skip: 0, take: 50 },
      });
      expect(result.map((t) => t.id)).toEqual([unassigned.id]);
    });

    it('workloadByAssignee counts only non-excluded statuses', async () => {
      const { requester, agentA, agentB, categoryId } = await ctx.seedBasicFixture();
      const mk = async (assignee: string | null, status: 'New' | 'Open' | 'Resolved') => {
        const t = await ctx.repos.tickets.create({
          title: 't',
          body: 'b',
          priority: 'Medium',
          creatorId: requester.id,
          categoryId,
        });
        if (assignee) await ctx.repos.tickets.updateAssignee(t.id, assignee);
        if (status !== 'New') {
          await ctx.repos.tickets.updateStatus(
            t.id,
            status,
            status === 'Resolved' ? new Date() : null,
          );
        }
        return t;
      };
      await mk(agentA.id, 'Open');
      await mk(agentA.id, 'Open');
      await mk(agentB.id, 'New');
      await mk(agentA.id, 'Resolved'); // excluded
      await mk(null, 'Open');

      const rows = await ctx.repos.tickets.workloadByAssignee({
        excludeStatuses: ['Resolved', 'Closed'],
      });

      const byAssignee = new Map(rows.map((r) => [r.assigneeId, r.count]));
      expect(byAssignee.get(agentA.id)).toBe(2);
      expect(byAssignee.get(agentB.id)).toBe(1);
      expect(byAssignee.get(null)).toBe(1);
    });

    it('uow.run rolls back on throw', async () => {
      const { requester, categoryId } = await ctx.seedBasicFixture();
      const ticket = await ctx.repos.tickets.create({
        title: 't',
        body: 'b',
        priority: 'Medium',
        creatorId: requester.id,
        categoryId,
      });

      await expect(
        ctx.uow.run(async (r) => {
          await r.tickets.updateStatus(ticket.id, 'Open', null);
          await r.history.record({
            ticketId: ticket.id,
            changedById: requester.id,
            field: 'status',
            oldValue: 'New',
            newValue: 'Open',
          });
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');

      const after = await ctx.repos.tickets.findById(ticket.id);
      expect(after?.status).toBe('New');
    });

    it('findById returns a defensive copy — callers cannot mutate stored state', async () => {
      const { requester, categoryId } = await ctx.seedBasicFixture();
      const created = await ctx.repos.tickets.create({
        title: 'original',
        body: 'b',
        priority: 'Low',
        creatorId: requester.id,
        categoryId,
      });

      const leaked = await ctx.repos.tickets.findById(created.id);
      // Attempt to corrupt stored state via the returned reference.
      if (leaked) {
        (leaked as { title: string }).title = 'MUTATED';
        (leaked as { status: 'New' | 'Open' }).status = 'Open';
      }

      const reread = await ctx.repos.tickets.findById(created.id);
      expect(reread?.title).toBe('original');
      expect(reread?.status).toBe('New');
    });

    it('countByStatus filters by creator and status', async () => {
      const { requester, agentA, categoryId } = await ctx.seedBasicFixture();
      const t1 = await ctx.repos.tickets.create({
        title: 'a',
        body: 'b',
        priority: 'Low',
        creatorId: requester.id,
        categoryId,
      });
      await ctx.repos.tickets.updateStatus(t1.id, 'Open', null);
      await ctx.repos.tickets.create({
        title: 'c',
        body: 'd',
        priority: 'Low',
        creatorId: agentA.id,
        categoryId,
      });

      expect(await ctx.repos.tickets.countByStatus({ status: 'Open' })).toBe(1);
      expect(await ctx.repos.tickets.countByStatus({ status: 'Open', creatorId: agentA.id })).toBe(
        0,
      );
      expect(await ctx.repos.tickets.countByStatus({ status: 'New', creatorId: agentA.id })).toBe(
        1,
      );
    });
  });
}
