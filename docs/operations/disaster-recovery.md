# Disaster recovery

How to rebuild a deployment from off-site material after its host is gone,
and how to rehearse it.

## What must exist off the host

| Item                                   | Where it lives                                              | Without it                                                           |
| -------------------------------------- | ----------------------------------------------------------- | -------------------------------------------------------------------- |
| `.env` (incl. `MASTER_ENCRYPTION_KEY`) | Password manager                                            | Encrypted dumps and encrypted columns cannot be read. Unrecoverable. |
| Restic repository password             | Password manager (shown once by `install.sh`)               | The off-site repository cannot be opened. Unrecoverable.             |
| R2 key pair for the bucket             | Password manager, or create a new one in R2                 | Create a new token for the bucket; nothing is lost.                  |
| Nightly encrypted DB dump              | R2 bucket, restic repository (host tag `etg-<environment>`) | Up to 24 h of data loss per missed night.                            |
| Code, compose file, images             | GitHub, GHCR                                                | —                                                                    |

Attachment and raw-email files are **not** copied off-site. They have short
TTLs; after a rebuild, links to older stored files return "not found".

## Off-site backup job

`infra/offsite-backup/` installs a systemd timer that runs at 02:30 UTC, after
the app's 02:00 UTC dump:

1. finds the newest `backup-*.sql.gz.etg` + `.meta` (fails if older than 26 h);
2. decrypts it inside the app container with the live key and runs `gzip -t`
   on the result, deleting the plaintext immediately;
3. `restic backup` of the two files, then `restic forget --prune` keeping
   7 daily, 4 weekly and 6 monthly snapshots;
4. pings a healthchecks.io check (`/start`, success, or `/fail` with a fixed
   body). A missed or failed night alerts through that check's integrations.

Install or re-install on a host (interactive, as root):

```bash
sudo bash infra/offsite-backup/install.sh <environment> \
  s3:https://<account-id>.r2.cloudflarestorage.com/<bucket>
```

It prompts for the bucket-scoped R2 key pair and the healthchecks.io ping URL,
generates the restic password on first run and prints it once. Status:

```bash
systemctl list-timers etg-r2-backup.timer
journalctl -u etg-r2-backup -n 50
```

If a run was killed mid-upload, the next one fails with "repository is
already locked". Check that no backup is running, then clear it:

```bash
sudo bash -c 'set -a; . /etc/etg-r2/restic.env; . /etc/etg-r2/credentials.env; restic unlock'
```

## Rebuild a host

1. **Base system.** Debian with Docker Engine and the compose plugin. Create
   `~/email-to-telegram/`, copy `docker-compose.yml` from the release tag you
   will run, and restore `.env` from the password manager (`chmod 600 .env`).
   `docker network create monitoring_scrape` (declared external in compose).
2. **Database only.** `docker compose --env-file .env up -d postgres`. Do not
   start the app yet: it runs migrations on an empty database.
3. **Fetch the dump.** Install restic, then:

   ```bash
   export RESTIC_REPOSITORY=s3:https://<account-id>.r2.cloudflarestorage.com/<bucket>
   export AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=...   # from the password manager
   read -rsp "restic password: " RESTIC_PASSWORD; export RESTIC_PASSWORD; echo
   restic snapshots --host etg-<environment>
   restic restore latest --host etg-<environment> --target /root/etg-restore
   ```

4. **Decrypt** with the app image (it reads `MASTER_ENCRYPTION_KEY` from `.env`):

   ```bash
   dir=$(dirname "$(find /root/etg-restore -name 'backup-*.sql.gz.etg')")
   name=$(basename "$(find /root/etg-restore -name 'backup-*.sql.gz.etg')" .sql.gz.etg)
   docker run --rm -u 0 --env-file .env -v "$dir":/restore:ro \
     ghcr.io/vladkarok/email-to-telegram:<release-tag> \
     sh -c "node dist/backupArchiveCli.js decrypt /restore/$name.sql.gz.etg /tmp/db.sql.gz /restore/$name.meta && cat /tmp/db.sql.gz" \
     > /root/etg-restore/db.sql.gz
   gzip -t /root/etg-restore/db.sql.gz
   ```

5. **Load** into the empty database:

   ```bash
   gunzip -c /root/etg-restore/db.sql.gz | \
     docker compose --env-file .env exec -T postgres psql -v ON_ERROR_STOP=1 -U emailtelegram -d emailtelegram
   ```

6. **Start the app.** `IMAGE_TAG=<release-tag> docker compose --env-file .env up -d app`,
   then check `docker compose ps` (healthy) and the logs for `Service ready`.
7. **Ingress.** Point the reverse proxy for `PUBLIC_BASE_URL` at the new host.
   The Cloudflare Worker's `VPS_URL` does not change if the hostname stays the
   same. Telegram uses long polling, so there is no webhook to update.
8. **Deploy runner.** Register a new self-hosted GitHub Actions runner with the
   environment's label so tag and `main` deploys work again.
9. **Off-site job.** Re-run `install.sh` with the **same** repository and put the
   existing restic password into `/etc/etg-r2/restic-password` before running
   it, so new snapshots join the old repository.
10. Delete `/root/etg-restore` once the service is verified.

## Rehearsal

Run steps 3–5 at least once after setup and after any key or bucket change,
but load into a **throwaway** Postgres container, never a running app's
database (prod data in the staging app would let the staging bot act on real
users):

```bash
docker run -d --name etg-drill -e POSTGRES_PASSWORD=drill \
  -e POSTGRES_USER=emailtelegram -e POSTGRES_DB=emailtelegram postgres:16-alpine
until docker exec etg-drill pg_isready -U emailtelegram -q; do sleep 1; done
gunzip -c /root/etg-restore/db.sql.gz | \
  docker exec -i etg-drill psql -v ON_ERROR_STOP=1 -U emailtelegram -d emailtelegram -q
docker exec etg-drill psql -U emailtelegram -d emailtelegram -tAc \
  "select (select count(*) from users), (select count(*) from email_addresses), (select max(created_at) from drizzle.__drizzle_migrations)"
docker rm -f etg-drill && rm -rf /root/etg-restore
```

Compare the counts and migration head with the live service, then record the
date and outcome in the plan or release notes.
