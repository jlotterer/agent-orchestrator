# Archive old activity logs

Agent logs are the largest part of orch's database. To keep the database small over months of use, orch moves the detailed logs of old runs into compressed files, and then removes them from the database. Decisions, questions, task summaries, validator verdicts and costs stay in the database.

## How archiving works

When orch starts, and every 24 hours after that, it archives each run that:

- Is finished (`done`, `stopped` or `failed`), and
- Was last updated more than `retention.eventDays` days ago (30 by default).

For each run, orch writes the log to `~/.orch/archive/<project>/<run-id>-events.jsonl.gz`, a gzip file with one JSON event per line. Only after the file is safely written does orch remove those events from the database. If writing fails, for example because the folder isn't writable, orch deletes nothing and logs an error.

orch never archives an unfinished run, however old it is.

After archiving, the log views for that run show "Log archived to `<path>`" instead of the events.

## Archive logs now

- Run:

  ```bash
  orch archive-events
  ```

  It works whether or not orch is running. orch prints "archived event logs of `<n>` run(s): `<run-ids>`", or "no finished runs older than `<days>` day(s) with live events" when there's nothing to archive. Each archived run also gets a decision that names its archive file.

## Change how long logs stay in the database

1. In `~/.orch/server.json`, set:

   ```json
   "retention": { "eventDays": 90 }
   ```

   Set `eventDays` to `0` to never archive.

2. Restart orch.

## Read an archived log

- Run:

  ```bash
  gunzip -c ~/.orch/archive/<project>/<run-id>-events.jsonl.gz | less
  ```
