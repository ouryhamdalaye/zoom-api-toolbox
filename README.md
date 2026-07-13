# API-Zoom

A tool for interacting with the Zoom API to retrieve meeting recordings and generate SQL INSERT statements for Moodle database integration.

## Features

- 🔐 **OAuth Authentication** - Server-to-Server OAuth integration with Zoom
- 📹 **Recording Retrieval** - Fetch Zoom meeting recordings by host or account
- 🔄 **SQL Generation** - Convert Zoom recording JSON data to SQL INSERT statements for Moodle
- 📎 **Link Export** - Export meeting share links to CSV from the Zoom API
- 🌍 **Environment Variables** - Secure credential management using `.env` files

## Prerequisites

- Node.js (for running the SQL generation script)
- VS Code with REST Client extension (or compatible HTTP client)
- Zoom API credentials (Account ID, Client ID, Client Secret)

## Setup

### 1. Clone the Repository

```bash
git clone <repository-url>
cd API-Zoom
```

### 2. Configure Environment Variables

Create a `.env` file in the root directory with your Zoom API credentials:

```env
BASE_URL=https://api.zoom.us/v2
ACCOUNT_ID=your_account_id
CLIENT_ID=your_client_id
CLIENT_SECRET=your_client_secret
HOST_EMAIL=your_host_email@example.com
FROM_DATE=2025-01-01
TO_DATE=2025-12-31
ZOOM_AUTH_BASE64=base64_encoded_client_id:client_secret
```

**Important:** 
- The `.env` file is gitignored and will not be committed to the repository
- `ZOOM_AUTH_BASE64` should be the base64 encoding of `CLIENT_ID:CLIENT_SECRET`
- You can generate it using: `echo -n "CLIENT_ID:CLIENT_SECRET" | base64`

### 3. Install REST Client Extension (VS Code)

If using VS Code, install the **REST Client** extension by Huachao Mao. This extension supports loading `.env` variables using the `{{$dotenv VARIABLE_NAME}}` syntax.

## Usage

### Using REST Client to Query Zoom API

Open `requests.http` in VS Code. The file contains pre-configured API requests:

1. **OAuth Token Request** - Authenticates and retrieves an access token
2. **Get Current User** - Retrieves information about the authenticated user
3. **List Recordings by Host** - Gets recordings for a specific host within a date range
4. **Get All Users** - Retrieves all Zoom users in the account
5. **Get All Recordings** - Retrieves all recordings for the account within a date range

Click the "Send Request" button above each request to execute it. The OAuth token response will be automatically used in subsequent requests.

### Exporting Meeting Share Links to CSV

The `export-links.js` script authenticates with Zoom, fetches cloud recordings for a given host, and writes a simple CSV with meeting name, date, and public share link.

#### Usage

```bash
npm run export-links -- <hostEmail> [--from YYYY-MM-DD] [--to YYYY-MM-DD]
```

Or directly:

```bash
node export-links.js <hostEmail> [--from YYYY-MM-DD] [--to YYYY-MM-DD]
```

#### Parameters

- `<hostEmail>` — Zoom host email (required)
- `--from`, `-f` — Start date in `YYYY-MM-DD` format (optional, defaults to today)
- `--to`, `-t` — End date in `YYYY-MM-DD` format (optional, defaults to today)

If neither `--from` nor `--to` is provided, the script exports **all** recordings from `2011-01-01` through today.

#### Examples

```bash
# Export all recordings for a host
node export-links.js host@example.com

# Export from a specific date through today
node export-links.js host@example.com --from 2024-01-01

# Export a specific date range
node export-links.js host@example.com --from 2024-01-01 --to 2024-12-31
```

OAuth credentials (`BASE_URL`, `ACCOUNT_ID`, `ZOOM_AUTH_BASE64`) are still read from `.env`.

#### Behavior

1. Obtains an OAuth access token via Server-to-Server auth (`ZOOM_AUTH_BASE64`)
2. Calls `GET /v2/users/{hostEmail}/recordings` with `from` and `to` query parameters
3. Splits the date range into 1-month chunks when needed (Zoom API limit)
4. Paginates results with `page_size=300` and `next_page_token`
5. Extracts `topic`, `start_time`, and `share_url` from each meeting (ignores `recording_files`)
6. Writes `outputfiles/zoom_links_{hostEmail}.csv`

#### Output CSV Format

```csv
topic,start_time,share_url
Weekly Team Sync,2025-01-15T10:00:00Z,https://zoom.us/rec/share/...
```

#### Error Handling

- Missing or invalid `.env` variables exit with a clear message
- OAuth failures (invalid token/credentials) are reported with troubleshooting hints
- HTTP 429 rate limits trigger automatic retries with backoff
- If no recordings are found, an empty CSV with headers is still written and a warning is displayed

### Generating SQL from Zoom Recording Data

The `generate-sql.js` script converts Zoom recording JSON files into SQL INSERT statements for Moodle's `prefix_zoom_meeting_recordings` table.

#### Usage

```bash
node generate-sql.js <inputfile> --zoomid=<id>
```

Or using alternative syntax:

```bash
node generate-sql.js <inputfile> -z <id>
node generate-sql.js <inputfile> --zoomid <id>
```

#### Parameters

- `<inputfile>` - Path to the JSON file containing Zoom recording data (required)
- `--zoomid=<id>` or `-z <id>` - Zoom ID to use in SQL INSERT statements (required)

#### Example

```bash
node generate-sql.js inputfiles/recordings.json --zoomid=43
```

The script will:
1. Read the input JSON file
2. Filter recordings by valid recording types
3. Generate SQL INSERT statements
4. Save output to `outputfiles/output_<inputfilename>.sql`

#### Supported Recording Types

The script only processes recordings with the following types:
- `shared_screen_with_speaker_view`
- `audio_transcript`
- `audio_only`
- `chat_file`
- `closed_caption`

#### Input JSON Format

The input JSON file should match the Zoom API recording response format:

```json
{
  "uuid": "meeting-uuid",
  "topic": "Meeting Name",
  "play_url": "https://zoom.us/rec/share/...",
  "recording_play_passcode": "passcode",
  "recording_files": [
    {
      "id": "recording-id",
      "recording_type": "shared_screen_with_speaker_view",
      "recording_start": "2025-01-15T10:00:00Z",
      "play_url": "https://zoom.us/rec/play/..."
    }
  ]
}
```

#### Output SQL Format

The generated SQL will create INSERT statements for the Moodle table:

```sql
-- Recording: Meeting Name | Type: shared_screen_with_speaker_view
INSERT INTO prefix_zoom_meeting_recordings (
  zoomid,
  meetinguuid,
  zoomrecordingid,
  name,
  externalurl,
  passcode,
  recordingtype,
  recordingstart,
  showrecording,
  timecreated,
  timemodified
)
VALUES (
  43,
  'meeting-uuid',
  'recording-id',
  'Meeting Name',
  'https://zoom.us/rec/share/...',
  'passcode',
  'shared_screen_with_speaker_view',
  UNIX_TIMESTAMP('2025-01-15T10:00:00Z'),
  1,
  UNIX_TIMESTAMP(),
  UNIX_TIMESTAMP()
);
```

## Project Structure

```
API-Zoom/
├── .env                      # Environment variables (gitignored)
├── .gitignore               # Git ignore rules
├── generate-sql.js          # Node.js script to convert JSON to SQL
├── export-links.js          # Node.js script to export meeting share links to CSV
├── requests.http            # REST Client HTTP requests for Zoom API
├── inputfiles/              # Input JSON files (gitignored, except sample_input.json)
│   └── sample_input.json    # Example input file (tracked in git)
└── outputfiles/             # Generated SQL files (gitignored, except sample_output.sql)
    └── sample_output.sql    # Example output file (tracked in git)
```

## API Endpoints Used

- `POST /oauth/token` - OAuth token endpoint
- `GET /v2/users/me` - Get current user
- `GET /v2/users/{email}/recordings` - Get recordings for a host
- `GET /v2/users` - Get all users
- `GET /v2/accounts/{accountId}/recordings` - Get all account recordings

## Troubleshooting

### REST Client Not Loading .env Variables

If REST Client isn't loading your `.env` variables:

1. Make sure the `.env` file exists in the project root
2. Restart VS Code
3. Verify the REST Client extension is installed and enabled
4. Check that variable names match exactly (case-sensitive)

### SQL Generation Errors

- **"Input file not found"**: Check that the input file path is correct
- **"JSON file must contain a 'recording_files' array"**: Ensure your JSON matches the expected format
- **"No valid recording files found"**: Check that recording types match the supported list

### API Authentication Issues

- Verify your credentials in `.env` are correct
- Check that `ZOOM_AUTH_BASE64` is properly encoded
- Ensure your Zoom app has the necessary permissions (OAuth scope: `recording:read`)

## License

Free to reuse

## Contributing


