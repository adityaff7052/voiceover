# Voiceover Studio

A mobile-friendly Hindi, Indian English and Hinglish text-to-speech web app. It uses one programming language across the browser and server: JavaScript.

- **Frontend:** plain HTML, CSS and browser JavaScript
- **Backend:** Node.js + Express
- **Speech:** Google Cloud Text-to-Speech
- **Final audio:** one combined WAV file
- **Long scripts:** split into UTF-8-safe sections under Google's per-request content limit, synthesized in order, then joined with FFmpeg
- **Deployment:** Docker on Render (connected to this GitHub repository)

## Important before you deploy

GitHub stores the source code. **GitHub Pages is not suitable for this full app** because it cannot run the private Node.js backend that holds the Google credential. Deploy the repository as a Docker web service on a hosting provider such as Render. Keep the Google service-account JSON out of GitHub.

Google Cloud Text-to-Speech requires a Google Cloud project, the API enabled, and billing configured. Speech generation is usage-billed; check the current Google pricing and set budget alerts/usage monitoring before sharing the site. A parent or guardian should manage the cloud billing account and service credentials.

## Features in this version

- Paste a long script or upload a `.txt` file (up to 1 MB).
- Hindi, English (India), Hinglish, or best-effort automatic language detection.
- Masculine Chirp 3 HD voices, with a character-name selection. The app uses the matching character suffix for Hindi and Indian English when Google lists that voice in both languages.
- Neural2 alternative with adjustable speaking rate and pitch.
- Progress updates while each section is generated.
- FFmpeg joins the sections into one WAV file, which can be played in the browser or downloaded.
- Server-side credentials, request validation, a per-IP generation limit, and a limit of two simultaneous generation jobs.
- Temporary generated recordings are deleted from the server after about one hour. Download the WAV file when it is ready.

### Voice controls note

Chirp 3 HD is the default because it is Google's expressive voice family and includes Hindi and Indian English voices. Speaking speed is adjustable for Chirp 3 HD. The pitch slider is available with **Neural2 · Adjustable**; pitch is not applied by this app to Chirp 3 HD. The two voice families may sound different. A matching character name across languages is the closest available option here, not a guarantee of perfectly identical timbre.

### Hinglish note

The Hinglish option uses a Hindi (`hi-IN`) voice for the whole script. Devanagari Hindi mixed with English words is generally the safer input style. Romanized Hindi pronunciation depends on the provider's language model and may not always sound exactly as intended. Auto-detection is a heuristic, not a full language-identification model; choose Hindi, English or Hinglish manually when the script is mixed.

## 1. Prepare Google Cloud Text-to-Speech

1. Create or select a Google Cloud project.
2. Enable **Cloud Text-to-Speech API** for that project.
3. Configure billing and review the current Text-to-Speech pricing and quotas.
4. Create a service account for this app. Give it only the permissions needed to call `texttospeech.synthesize` and `texttospeech.voices.list`. A custom role containing those permissions is an option if your organization does not offer a suitable predefined role.
5. Create a JSON key for the service account. Store it securely. **Never upload it to GitHub, paste it in a source file, or put it in frontend JavaScript.**

Google limits synchronous text input to 5,000 bytes per request. This app targets 4,400 UTF-8 bytes per section to leave a margin; that is why long scripts are split internally.

## 2. Run locally

Requirements:

- Node.js 22 or later
- FFmpeg installed and available on your `PATH`
- A Google Cloud service-account JSON key with Text-to-Speech access

From the project folder:

```bash
npm install
```

Copy `.env.example` to `.env` and set the path to your downloaded credentials file:

```env
GOOGLE_APPLICATION_CREDENTIALS=./service-account.json
GOOGLE_CLOUD_PROJECT=your-google-cloud-project-id
PORT=10000
```

Put the service-account file in the project folder as `service-account.json` (it is ignored by Git). Then start the server:

```bash
npm test
npm start
```

Open `http://localhost:10000` in your browser. The test command checks the UTF-8-safe chunking and language-selection helpers without calling Google Cloud.

On Windows, install FFmpeg and make sure its `bin` directory is in `PATH`. If FFmpeg is installed somewhere unusual, set `FFMPEG_PATH` to the full path of the FFmpeg executable.

### Alternative local authentication

Instead of `GOOGLE_APPLICATION_CREDENTIALS`, you may set `GOOGLE_SERVICE_ACCOUNT_JSON` to the complete JSON contents of the service-account key. Do not commit the value. The path-based method is usually easier for local development.

## 3. Push the project to GitHub

1. Create a new, empty GitHub repository.
2. Upload the contents of this project folder (not the ZIP file itself), or use Git:

```bash
git init
git add .
git commit -m "Create Voiceover Studio"
git branch -M main
git remote add origin https://github.com/YOUR-ACCOUNT/YOUR-REPOSITORY.git
git push -u origin main
```

Before pushing, confirm that `.env`, `service-account.json`, and all credential key files are excluded by `.gitignore`.

## 4. Deploy the GitHub repository on Render

1. Sign in to Render and choose **New → Web Service**.
2. Connect the GitHub repository you just created.
3. Choose **Docker** as the runtime. The repository includes a `Dockerfile` that installs Node.js dependencies and FFmpeg.
4. Use `/health` as the health-check path if the setup screen offers it.
5. In the Render service's **Environment** settings, add:
   - `GOOGLE_SERVICE_ACCOUNT_JSON` = the complete contents of your service-account JSON file
   - `GOOGLE_CLOUD_PROJECT` = your Google Cloud project ID
6. Save and deploy. Render supplies the `PORT` environment variable; the app listens on it.
7. Open the `onrender.com` URL shown in the Render dashboard.

Keep the service-account JSON only in the hosting provider's secret/environment settings. Do not add it to the repository. Check your host's current pricing and limitations before choosing a plan; long TTS jobs can take longer than a short web request.

## 5. Configuration

| Variable | Purpose | Default |
|---|---|---|
| `PORT` | HTTP server port | `10000` |
| `GOOGLE_CLOUD_PROJECT` | Google Cloud project ID | inferred from service-account JSON when present |
| `GOOGLE_APPLICATION_CREDENTIALS` | Local path to service-account JSON | unset |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Service-account JSON as a server-side environment variable | unset |
| `MAX_TEXT_CHARS` | Maximum script length | `120000` |
| `GENERATE_RATE_LIMIT` | Generation requests per IP per 15-minute window | `8` |
| `FFMPEG_PATH` | Optional FFmpeg executable path | `ffmpeg` |

Use **one** of `GOOGLE_APPLICATION_CREDENTIALS` or `GOOGLE_SERVICE_ACCOUNT_JSON`. On Render, use the environment-variable method shown above.

## Operational notes and limitations

- WAV is uncompressed PCM audio, so downloads are larger than MP3 files. This is intentional because the requested output format is WAV.

- The app stores active job state and temporary WAV files on the server's local temporary disk. Deploying/restarting the server removes active jobs and their files. This first version does not provide a permanent audio library or user accounts.
- Completed WAV files are automatically removed after roughly one hour. Download the file before then.
- Two generation jobs may run at a time. A small per-IP rate limit helps protect the Google Cloud project from accidental repeated requests; it is not a complete public-user quota or account system.
- Auto language detection is intentionally simple. Mixed-language scripts are best handled by selecting the language mode yourself.
- The app does not guarantee a single identical acoustic voice across languages; it selects the same named Chirp character where available.
- The browser upload accepts plain `.txt` files only. PDF and Word files are not included in this version.
- For a public service with many users, add user authentication, per-user quotas, durable job storage, and Cloud Storage before opening it widely.

## Troubleshooting

**“Google Cloud authentication failed”**  
Check that `GOOGLE_SERVICE_ACCOUNT_JSON` is valid JSON on Render, or that `GOOGLE_APPLICATION_CREDENTIALS` points to the correct local file. Confirm the service account has the two Text-to-Speech permissions and that the API is enabled.

**“No compatible male voices”**  
Check that the Text-to-Speech API is enabled and that the selected voice family is available for `hi-IN` or `en-IN` in your project. Google may update its voice catalogue; this app loads the current list from the API.

**“FFmpeg was not found”**  
The included Dockerfile installs FFmpeg. For local use, install FFmpeg and add it to `PATH` or set `FFMPEG_PATH`.

**Generation fails on a very long script**  
Check Google Cloud quotas and billing. Try again after a quota limit resets. The app splits text under the request-size limit, but each section still creates a billable TTS request.

## Official references

- [Google Cloud Text-to-Speech: voices and languages](https://cloud.google.com/text-to-speech/docs/list-voices-and-types)
- [Google Cloud Text-to-Speech: quotas and limits](https://cloud.google.com/text-to-speech/quotas)
- [Google Cloud Text-to-Speech: Node.js client library](https://googleapis.dev/nodejs/text-to-speech/latest/)
- [Google Cloud Text-to-Speech: pricing](https://cloud.google.com/text-to-speech/pricing)
- [Render: deploy with Docker](https://render.com/docs/docker)
- [Render: environment variables and secrets](https://render.com/docs/configure-environment-variables)
