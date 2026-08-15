# Rainbow Six Match Checker — Web

Browser-based version of the original desktop app. Give it a stats.cc
player URL and up to 5 names, and it scrapes that player's recent ranked
matches to show how often each of those names shows up alongside them.

## Local setup

```bash
pip install -r requirements.txt
python app.py
```

Open http://127.0.0.1:5000

## Deploy on Render (free)

Render has a free Web Service tier that works well for this app (the
whole Flask frontend + API runs as one service).

### Option A — Blueprint (easiest)

1. Push this folder to a GitHub repo.
2. Go to [dashboard.render.com](https://dashboard.render.com) → **New** → **Blueprint**.
3. Connect the repo. Render will pick up `render.yaml` and create the service.
4. Deploy. Your app will be at `https://<name>.onrender.com`.

### Option B — Manual Web Service

1. Push this folder to a GitHub repo.
2. **New** → **Web Service** → connect the repo.
3. Settings:
   - **Runtime**: Python
   - **Build Command**: `pip install -r requirements.txt`
   - **Start Command**: `gunicorn app:app --bind 0.0.0.0:$PORT --workers 1 --threads 8 --timeout 120`
   - **Plan**: Free
4. Deploy.

### Notes for production

- Free tier spins down after ~15 min of inactivity. First request after
  sleep can take 30–60 s to wake up.
- Scraping is rate-limited and can take several minutes for large match
  counts — the long gunicorn timeout and threaded worker are intentional.
- Job state is in-memory and disk writes (`job_*` folders) are ephemeral
  on free instances. Fine for single-user / casual use.
- Do **not** enable Flask debug mode in production.

## Why not Vercel + Render split?

Vercel is excellent for static frontends / serverless functions, but this
app's long-running scraper + in-memory job polling doesn't map well to
Vercel's short function timeouts. Keeping everything on one Render Web
Service is simpler and free.
