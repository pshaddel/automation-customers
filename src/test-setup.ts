process.env.NODE_ENV = "test";
process.env.DATABASE_URL ??=
  "postgres://postgres:postgres@localhost:5491/automation";
process.env.REDIS_URL ??= "redis://localhost:6391";
