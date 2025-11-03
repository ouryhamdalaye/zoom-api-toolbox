-- Recording: Some recording | Type: shared_screen_with_speaker_view
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
  1,
  'xxx', -- meetinguuid -> uuid
  'xxx-xx-xx-xx', -- zoomrecordingid -> id
  'Some Recording', -- zoom meeting name -> topic
  'https://us06web.zoom.us/rec/play/xxxxx', -- externalurl -> play_url
  '', -- passcode -> recording_play_passcode
  'shared_screen_with_speaker_view', -- recording type -> recording_type
  UNIX_TIMESTAMP('2025-10-01T00:00:00Z'), -- recordingstart -> recording_start
  1,
  UNIX_TIMESTAMP(), -- timecreated = now()
  UNIX_TIMESTAMP()  -- timemodified = now()
);

-- Recording: Some Recording | Type: audio_only
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
  1,
  'xxxxx', -- meetinguuid -> uuid
  'xxx-xx-xx-xx', -- zoomrecordingid -> id
  'Some Recording', -- zoom meeting name -> topic
  'https://us06web.zoom.us/rec/play/xxxxx', -- externalurl -> play_url
  '', -- passcode -> recording_play_passcode
  'audio_only', -- recording type -> recording_type
  UNIX_TIMESTAMP('2025-10-01T00:00:00Z'), -- recordingstart -> recording_start
  1,
  UNIX_TIMESTAMP(), -- timecreated = now()
  UNIX_TIMESTAMP()  -- timemodified = now()
);

-- Recording: Some Recording | Type: chat_file
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
  1,
  'xxxx', -- meetinguuid -> uuid
  'xxx-xxx-xxx', -- zoomrecordingid -> id
  'Some Recording', -- zoom meeting name -> topic
  'https://us06web.zoom.us/rec/play/xxxxx', -- externalurl -> play_url
  '', -- passcode -> recording_play_passcode
  'chat_file', -- recording type -> recording_type
  UNIX_TIMESTAMP('2025-10-01T00:00:00Z'), -- recordingstart -> recording_start
  1,
  UNIX_TIMESTAMP(), -- timecreated = now()
  UNIX_TIMESTAMP()  -- timemodified = now()
);

--- ....