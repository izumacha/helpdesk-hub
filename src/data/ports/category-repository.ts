export interface CategorySummary {
  id: string;
  name: string;
}

export interface CategoryRepository {
  list(): Promise<CategorySummary[]>;
}
