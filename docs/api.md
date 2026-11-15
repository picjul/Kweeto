# HTTP API

[← Back to the README](../README.md). The interactive version is served by the backend at `http://localhost:8000/docs`.

| Method | Endpoint | Description |
|---|---|---|
| POST | `/api/images/upload` | multipart `files[]`; skips exact duplicates; starts embedding |
| GET | `/api/images?status=&q=&offset=&limit=` | gallery (`q` = part of the file name, literal) |
| GET | `/api/images/{id}` | detail with `boxes` and `proposals` |
| GET | `/api/images/{id}/similar?k=` | most similar images |
| PUT | `/api/images/{id}/annotations` | `{boxes[], rejected[], done}` → `{delta_count, message}` |
| POST | `/api/images/{id}/segment` | `{points: [[x,y]], box: [x,y,w,h] \| null}` → tight box around the object (click-to-box / snapping) |
| POST | `/api/images/{id}/segment/prepare` | pre-computes the SAM image encoding in the background (first click becomes instant) |
| GET | `/api/queue/next?position=&exclude=` | next lesson image (3 hard + 1 easy) |
| GET/POST | `/api/classes` | list / create |
| PATCH/DELETE | `/api/classes/{id}` | rename / delete (only without boxes) |
| GET | `/api/batch` | Harvest groups by origin, with hidden checks |
| POST | `/api/batch/review` | `{accept[], reject[], correct[]}` → counts, checks caught/missed, delta |
| GET | `/api/questions` | regenerates and returns open questions |
| POST | `/api/questions/{id}/answer` | `{action: submit / annotate / ignore, assignments[]}` |
| POST | `/api/questions/{id}/dismiss` | postpone the question |
| GET | `/api/health` | liveness probe: `{status, version, project}` (no project needed) |
| GET | `/api/stats` | counters, worker progress, Pixel's message (active project) |
| GET/PUT | `/api/settings` | engine thresholds (PUT recomputes) |
| POST | `/api/reset` | deletes the teaching, keeps images and embeddings |
| POST | `/api/rescan` | recomputes every image's candidate regions (keeps boxes and history) |
| GET/PUT | `/api/engine` | engine profiles / switch the active project's profile |
| GET/POST | `/api/projects` | list (with stats and Pixel options) / create `{name, pixel?, open}` |
| PATCH/DELETE | `/api/projects/{id}` | rename or restyle its Pixel / delete the project and all its files |
| POST | `/api/projects/{id}/open` | make it the active project |
| POST | `/api/projects/demo` | create and open the demo project (synthetic images, three classes, fast engine) |
| GET/POST | `/api/exports` | formats, candidates and past exports / start one `{formats, masks, images, scope, train, val, test}` |
| GET/DELETE | `/api/exports/{id}` | progress (`phase` masks → writing → done) / delete |
| GET | `/api/exports/{id}/download` | the zip |
| DELETE | `/api/images/{id}` | delete an image with its boxes, regions and files |
| POST | `/api/images/delete` | `{ids: [...]}` bulk deletion |
| POST | `/api/imports` | open an import (staging area) |
| POST | `/api/imports/{id}/files` | multipart `files[]`, the file name carries the relative path; zips are extracted |
| GET | `/api/imports/{id}/preview?format=` | detected formats, matched images, classes, warnings |
| POST | `/api/imports/{id}/commit` | `{format, complete, empty_negative, skip_classes}` → background job |
| GET/DELETE | `/api/imports/{id}` | progress and Pixel's message / discard |
| GET | `/api/dataset-health` | class balance, near-duplicate groups, suspicious boxes |
| POST | `/api/dataset-health/dismiss`, `/api/dataset-health/restore` | `{key}`: keep a finding / show the kept ones again |
| PATCH/DELETE | `/api/boxes/{id}` | `{class_id}`: relabel one box (a correction) / delete it |
| POST | `/api/sessions?resume=` | start (or resume) a lesson session |
| GET | `/api/sessions`, `/api/sessions/{id}` | latest recaps / one recap |
| POST | `/api/sessions/{id}/end` | end the session: the recap is frozen |
