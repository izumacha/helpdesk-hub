/**
 * Provider-neutral query primitives used by repository ports.
 *
 * Adapters are responsible for translating these into native query shapes
 * (e.g. Prisma `WhereInput`, Drizzle/Kysely builders, raw SQL).
 */

export interface TextFilter {
  contains: string;
  /** If true, match is case-insensitive (adapter-specific implementation). */
  caseInsensitive?: boolean;
}

export interface Page {
  skip: number;
  take: number;
}

export interface Sort<Field extends string> {
  field: Field;
  direction: 'asc' | 'desc';
}
