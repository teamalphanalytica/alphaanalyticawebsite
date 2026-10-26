# Database tests

These run the real API code against a throwaway local Postgres, with every migration applied.
They are not part of `npm test` because they need Postgres.

```sh
# a local Postgres 16 on a unix socket, then:
for f in netlify/database/migrations/*.sql; do psql -h "$PGHOST" -p "$PGPORT" -U postgres -v ON_ERROR_STOP=1 -q -f "$f"; done
PGHOST=/path/to/socket/dir PGPORT=5499 npm run test:db
```

They empty the `clients`, `call_clicks` and `prospects` tables, so never point them at a real database.
