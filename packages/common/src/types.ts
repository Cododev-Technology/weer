// These should match the link_type ENUM in the database (packages/server-shared/database/tables/urls.sql)
export type LinkType =
  | "classic"
  | "custom"
  | "affix" // custom on username
  | "ultra"
  | "digit"
  | "qr";
