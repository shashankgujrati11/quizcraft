# QuizCraft — GitHub Pages + SQL Database

This version uses **MySQL** as the shared database. GitHub Pages hosts only the frontend; the Node.js API must be deployed separately and connected to a MySQL database. After both are configured, conductor accounts, quizzes, questions, submissions, and leaderboards are shared across devices.

## Architecture

- **Frontend:** GitHub Pages (`index.html`, `student.html`, `conductor.html`, `app.js`, `style.css`, `config.js`)
- **API:** Node.js + Express in `backend/`
- **Database:** MySQL using `backend/schema.sql`
- **Authentication:** bcrypt password hashes + expiring JWTs
- **Scoring:** correct answers are never sent to student browsers; the server calculates scores

## Step 1 — Create the MySQL database

1. Create a MySQL 8 database using your hosting provider, or run MySQL locally for development.
2. Select that database in your SQL console/phpMyAdmin/Workbench, then run all commands from `backend/schema.sql`. The schema file does not assume your provider allows creating databases.
3. Create a database user that can access the `quizcraft` database. Use a strong password and only the permissions the app needs (`SELECT`, `INSERT`, `UPDATE`, `DELETE`, and schema permissions during setup).
4. Keep database credentials private. **Never put database credentials in frontend files or commit a real `.env` file to GitHub.**

The SQL schema creates these tables: `conductors`, `quizzes`, `questions`, `question_options`, `attempts`, and `attempt_answers`.

## Step 2 — Deploy the API

You can deploy the API to a Node.js host such as Render or Railway. The host and database provider may be different services.

1. Push this project to GitHub. The backend folder is `backend/`.
2. Create a new **Web Service** from your repository and set its **Root Directory** to `backend`.
3. Build command: `npm install`
4. Start command: `npm start`
5. Add these environment variables in the hosting dashboard (do not add them to source code):

   - `NODE_ENV` = `production`
   - `DB_HOST` = hostname supplied by your MySQL provider
   - `DB_PORT` = port supplied by your MySQL provider (usually `3306`)
   - `DB_NAME` = `quizcraft` (or the database name you created)
   - `DB_USER` = database username
   - `DB_PASSWORD` = database password
   - `JWT_SECRET` = a random secret at least 32 characters long
   - `FRONTEND_ORIGINS` = your GitHub Pages **origin**, e.g. `https://your-username.github.io`

   For a GitHub Pages project site like `https://your-username.github.io/quizcraft/`, the CORS origin is still `https://your-username.github.io` (do not include `/quizcraft/`). For a custom domain, use that domain's origin instead. If you have multiple frontend origins, separate them with commas.

6. If your database provider requires TLS, use its recommended SSL settings. This API enables certificate validation by default. Do not disable certificate validation for a production database.
7. Once deployed, open `https://YOUR-BACKEND-HOST/api/health`. A successful response looks like `{"ok":true,"service":"QuizCraft API","database":"connected"}`.

## Step 3 — Point GitHub Pages to the API

1. Open `config.js` in the repository.
2. Replace the placeholder with your real deployed backend URL, for example:

   ```js
   window.QUIZCRAFT_API_URL = "https://quizcraft-api.onrender.com";
   ```

   Use the exact API base URL with **no trailing slash**. This URL is public, so it must not contain secrets.
3. Commit and push `config.js` along with the other frontend files.
4. In your GitHub repository, open **Settings → Pages** and publish from your desired branch and folder (usually `main` and `/(root)`).
5. Open the live GitHub Pages site and register a conductor account.

## Step 4 — Verify the complete flow

1. Register a conductor account using a valid email and a password of at least 8 characters.
2. Create a quiz with at least one question and four distinct options.
3. Copy the student link or show its QR code.
4. Open that link on a different device or private browser window, enter a student name, and complete the quiz.
5. Return to the conductor dashboard and open the leaderboard. The attempt should appear there because it is stored in MySQL.

The QR/link is generated from the currently published `student.html` URL and includes the quiz code, so it works for both user/organization Pages and project Pages URLs.

## Troubleshooting

- **“Backend URL is not configured”**: replace the placeholder in `config.js`, commit, and wait for Pages to redeploy.
- **CORS error**: set `FRONTEND_ORIGINS` to the exact site origin (scheme + hostname, no path), then restart/redeploy the API.
- **Database unavailable / schema not installed**: confirm the DB credentials and run `backend/schema.sql` against the configured database.
- **API returns 500 on startup**: check API host logs and confirm `JWT_SECRET` is at least 32 characters.
- **QR opens the site but no quiz is found**: confirm the API is healthy and the quiz is open; check that frontend `config.js` points to the same API used by the conductor.
- **GitHub Pages is not a backend host**: do not try to run `backend/server.js` on Pages. Deploy the API separately.

## Security notes

- Never commit `.env` or database passwords. `.env.example` is safe as a template; create a private `.env` locally if running the API on your computer.
- The backend hashes passwords with bcrypt and uses expiring JWTs. The browser stores only the signed session token, not the conductor password.
- Student clients receive question text and options only. The server holds the answer key and calculates the result.
- This is a starter app, not a certified high-stakes exam platform. Add backups, monitoring, privacy notice/data retention rules, and additional abuse controls before production use.

## Local API development

```bash
cd backend
npm install
cp .env.example .env
# Edit .env with your local MySQL settings and a strong JWT_SECRET
npm run dev
```

Set `config.js` to `http://localhost:3000` for local API testing; localhost HTTP is permitted. For deployed GitHub Pages, always use the HTTPS API URL. If your local MySQL instance does not support TLS, set `DB_SSL=false` in your local `.env` only.
