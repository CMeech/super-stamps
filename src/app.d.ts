declare global {
  namespace App {
    interface Locals {
      db: import('#lib/server/database.ts').Database;
      auth: import('#lib/server/auth.ts').Auth;
      user: import('#lib/server/auth.ts').User | null;
      session: import('#lib/server/auth.ts').Session | null;
    }

    interface Error {
      message: string;
      code?: string;
    }

    interface PageData {
      user: import('#lib/server/auth.ts').User | null;
      session: import('#lib/server/auth.ts').Session | null;
      metadata?: {
        title?: string;
        description?: string;
        image?: string;
        url?: string;
        breadcrumbs?: {
          title: string;
          href: string;
        }[];
      };
    }
  }
}

export {};
