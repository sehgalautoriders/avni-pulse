// AVNI Pulse - where the live data lives. Our Supabase project "Sehgal Hero" (Mumbai region).
// The key below is the PUBLIC (anon) key: it can only call the pulse_* functions and read the pulse_ticks counter.
// Every rule (who may vote, the presenter key, time limits) is checked inside the database, never in this page.
export const SUPABASE_URL = 'https://tiwfuwfzjxcsbrifcdpu.supabase.co';
export const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRpd2Z1d2Z6anhjc2JyaWZjZHB1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU1OTUxNTIsImV4cCI6MjEwMTE3MTE1Mn0.9nCkV795DHacIiqroP1m0ZvbbVsVjMHi8-okIwjERRc';

// The address people open on their phones. The presenter screen shows it with the code and a QR picture.
export const JOIN_BASE = 'https://sehgalautoriders.github.io/avni-pulse/';

// The build string: the release line checks that the live site serves exactly this text (tools/release/Pulse-Release.ps1).
export const PULSE_BUILD = '24-10-2026.1';
