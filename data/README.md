# Local task data

This folder is the only task-data location for Daily Todo Chi Edition.

- daily-todo-data.json: the current task database, written after every change.
- backups/daily-todo-backup-YYYY-MM-DD.json: one recovery snapshot per calendar day, retained for today plus the preceding 89 calendar days.

The runtime files are plain JSON. They are ignored by Git and never pushed to GitHub, but Synology Drive may synchronize them as normal files.
