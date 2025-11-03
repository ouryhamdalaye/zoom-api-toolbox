// Usage: node generate-sql.js <inputfile> --zoomid=<id>
//   or: node generate-sql.js <inputfile> [-z <id> | --zoomid <id>]
// Example: node generate-sql.js input.json --zoomid=1
// Note: Both inputfile and zoomid are required parameters

const fs = require('fs');
const path = require('path');

// Valid recording types
const VALID_RECORDING_TYPES = [
  'shared_screen_with_speaker_view',
  'audio_transcript',
  'audio_only',
  'chat_file',
  'closed_caption'
];

/**
 * Convert ISO date string to UNIX_TIMESTAMP format for SQL
 * @param {string} isoDate - ISO 8601 date string
 * @returns {string} SQL UNIX_TIMESTAMP expression
 */
function isoToUnixTimestamp(isoDate) {
  if (!isoDate) return 'UNIX_TIMESTAMP()';
  // Use ISO format directly in UNIX_TIMESTAMP
  return `UNIX_TIMESTAMP('${isoDate}')`;
}

/**
 * Escape single quotes in SQL strings
 * @param {string} str - String to escape
 * @returns {string} Escaped string
 */
function escapeSql(str) {
  if (str === null || str === undefined) return '';
  return String(str).replace(/'/g, "''");
}

/**
 * Generate SQL INSERT statement for a recording file
 * @param {Object} recordingFile - Recording file object
 * @param {Object} meetingData - Parent meeting data (uuid, topic, recording_play_passcode, etc.)
 * @param {number} zoomId - Zoom ID (hardcoded as 43 for now)
 * @returns {string} SQL INSERT statement
 */
function generateInsertStatement(recordingFile, meetingData, zoomId) {
  const meetinguuid = escapeSql(meetingData.uuid || '');
  const zoomrecordingid = escapeSql(recordingFile.id || '');
  const name = escapeSql(meetingData.topic || '');
  // play_url is at parent level (outside recording_files array)
  const externalurl = escapeSql(meetingData.play_url || recordingFile.play_url || '');
  const passcode = escapeSql(meetingData.recording_play_passcode || '');
  const recordingtype = escapeSql(recordingFile.recording_type || '');
  const recordingstart = isoToUnixTimestamp(recordingFile.recording_start);

  return `INSERT INTO prefix_zoom_meeting_recordings (
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
  ${zoomId},
  '${meetinguuid}', -- meetinguuid -> uuid
  '${zoomrecordingid}', -- zoomrecordingid -> id
  '${name}', -- zoom meeting name -> topic
  '${externalurl}', -- externalurl -> play_url
  '${passcode}', -- passcode -> recording_play_passcode
  '${recordingtype}', -- recording type -> recording_type
  ${recordingstart}, -- recordingstart -> recording_start
  1,
  UNIX_TIMESTAMP(), -- timecreated = now()
  UNIX_TIMESTAMP()  -- timemodified = now()
);`;
}

/**
 * Main function to process JSON file and generate SQL
 * @param {string} inputFilePath - Path to input JSON file
 * @param {number} zoomId - Zoom ID to use in SQL INSERT statements (default)
 */
function generateSqlFromJson(inputFilePath, zoomId) {
  // Check if input file exists
  if (!fs.existsSync(inputFilePath)) {
    console.error(`Error: Input file not found: ${inputFilePath}`);
    process.exit(1);
  }

  // Read and parse JSON file
  let jsonData;
  try {
    const fileContent = fs.readFileSync(inputFilePath, 'utf8');
    jsonData = JSON.parse(fileContent);
  } catch (error) {
    console.error(`Error reading/parsing JSON file: ${error.message}`);
    process.exit(1);
  }

  // Ensure recording_files exists
  if (!jsonData.recording_files || !Array.isArray(jsonData.recording_files)) {
    console.error('Error: JSON file must contain a "recording_files" array');
    process.exit(1);
  }

  // Filter and process recording files
  const validRecordings = jsonData.recording_files.filter(file => 
    file.recording_type && VALID_RECORDING_TYPES.includes(file.recording_type)
  );

  if (validRecordings.length === 0) {
    console.warn('Warning: No valid recording files found (filtered by recording_type)');
  }

  // Generate SQL statements
  const sqlStatements = validRecordings.map((recordingFile, index) => {
    const name = jsonData.topic || 'Unknown Meeting';
    const type = recordingFile.recording_type || 'unknown';
    
    // Add comment before each INSERT
    const comment = `-- Recording: ${escapeSql(name)} | Type: ${escapeSql(type)}`;
    const insertStatement = generateInsertStatement(recordingFile, jsonData, zoomId);
    
    return comment + '\n' + insertStatement;
  });

  // Combine all SQL statements
  const sqlContent = sqlStatements.join('\n\n');

  // Generate output file path
  const inputFileName = path.basename(inputFilePath, path.extname(inputFilePath));
  const outputFileName = `output_${inputFileName}.sql`;
  const outputDir = path.join(__dirname, 'outputfiles');
  const outputPath = path.join(outputDir, outputFileName);

  // Ensure output directory exists
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  // Write SQL file
  try {
    fs.writeFileSync(outputPath, sqlContent, 'utf8');
    console.log(`✓ Successfully generated SQL file: ${outputPath}`);
    console.log(`  Processed ${validRecordings.length} recording(s) from ${jsonData.recording_files.length} total`);
  } catch (error) {
    console.error(`Error writing SQL file: ${error.message}`);
    process.exit(1);
  }
}

// Main execution
if (require.main === module) {
  // Parse command line arguments
  const args = process.argv.slice(2);
  let inputfile = null;
  let zoomId = null;

  // Parse arguments (support --zoomid=43 or -z 43 or positional)
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    
    if (arg.startsWith('--zoomid=')) {
      const zoomIdValue = arg.split('=')[1];
      if (!zoomIdValue || zoomIdValue.trim() === '') {
        console.error(`Error: zoomid value cannot be empty`);
        process.exit(1);
      }
      zoomId = parseInt(zoomIdValue, 10);
      if (isNaN(zoomId)) {
        console.error(`Error: Invalid zoomid value: ${zoomIdValue}`);
        process.exit(1);
      }
    } else if (arg === '-z' || arg === '--zoomid') {
      if (i + 1 < args.length) {
        const zoomIdValue = args[i + 1];
        if (!zoomIdValue || zoomIdValue.trim() === '') {
          console.error(`Error: zoomid value cannot be empty`);
          process.exit(1);
        }
        zoomId = parseInt(zoomIdValue, 10);
        if (isNaN(zoomId)) {
          console.error(`Error: Invalid zoomid value: ${zoomIdValue}`);
          process.exit(1);
        }
        i++; // skip next argument
      } else {
        console.error(`Error: ${arg} requires a value`);
        process.exit(1);
      }
    } else if (!inputfile) {
      // First non-flag argument is the input file
      inputfile = arg;
    }
  }

  // Check if inputfile is provided
  if (!inputfile || inputfile.trim() === '') {
    console.error('Error: Input file path is required');
    console.error('Usage: node generate-sql.js <inputfile> --zoomid=<id>');
    console.error('   or: node generate-sql.js <inputfile> [-z <id> | --zoomid <id>]');
    console.error('Example: node generate-sql.js input.json --zoomid=43');
    process.exit(1);
  }

  // Check if zoomId is provided
  if (zoomId === null || zoomId === undefined) {
    console.error('Error: zoomid parameter is required');
    console.error('Usage: node generate-sql.js <inputfile> --zoomid=<id>');
    console.error('   or: node generate-sql.js <inputfile> [-z <id> | --zoomid <id>]');
    console.error('Example: node generate-sql.js input.json --zoomid=43');
    process.exit(1);
  }

  // Resolve path (support both relative and absolute paths)
  const inputFilePath = path.isAbsolute(inputfile) 
    ? inputfile 
    : path.resolve(process.cwd(), inputfile);

  generateSqlFromJson(inputFilePath, zoomId);
}

module.exports = { generateSqlFromJson };

