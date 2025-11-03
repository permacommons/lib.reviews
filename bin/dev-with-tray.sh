#!/bin/bash
#
# dev-with-tray.sh - Run lib.reviews dev server with a system tray icon
#
# This script starts the development server and displays a system tray icon
# using yad (Yet Another Dialog). The icon allows you to toggle the server
# on/off by clicking it, and changes appearance to reflect server state:
#   - Stop icon (⏹): Server is running, click to stop
#   - Play icon (▶): Server is stopped, click to start
#
# Requirements:
#   - yad (Yet Another Dialog) - Available in most Linux distro repos
#   - A system tray (works best with GNOME/GTK-based desktop environments)
#
# Usage:
#   npm run start-dev-yad
#   OR
#   bash bin/dev-with-tray.sh
#
# The script will clean up the tray icon when you press Ctrl+C in the terminal.

# Create temp files for tracking server PID, yad communication pipe, and toggle script
PID_FILE=$(mktemp)
YAD_PIPE=$(mktemp -u)
mkfifo "$YAD_PIPE"  # Named pipe for sending commands to yad
TOGGLE_SCRIPT=$(mktemp)

# Cleanup function - kills server and tray icon, removes temp files
cleanup() {
  exec 3>&- 2>/dev/null  # Close the pipe file descriptor
  PID=$(cat "$PID_FILE" 2>/dev/null)
  [ -n "$PID" ] && kill $PID 2>/dev/null  # Kill dev server if running
  [ -n "$YAD_PID" ] && kill $YAD_PID 2>/dev/null  # Kill yad tray icon
  rm -f "$TOGGLE_SCRIPT" "$PID_FILE" "$YAD_PIPE"  # Clean up temp files
  exit
}

# Trap signals for cleanup (Ctrl+C, kill signal, or normal exit)
trap cleanup SIGINT SIGTERM EXIT

# Start the dev server in background
echo -e "\033[36mdev-with-tray.sh:\033[0m Starting server"
NODE_ENV=development DEBUG=libreviews:* node --import tsx/esm bin/www.ts &
echo $! > "$PID_FILE"  # Save server PID for later

# Create a toggle script that runs when the tray icon is clicked
# This script checks if server is running and toggles it on/off
cat > "$TOGGLE_SCRIPT" <<EOF
#!/bin/bash
PID=\$(cat "$PID_FILE" 2>/dev/null)
if [ -n "\$PID" ] && kill -0 \$PID 2>/dev/null; then
  # Server is running - stop it
  echo -e "\033[36mdev-with-tray.sh:\033[0m Stopping server"
  kill \$PID 2>/dev/null
  # Update tray icon to play (start) state
  echo "icon:media-playback-start" > "$YAD_PIPE"
  echo "tooltip:lib.reviews dev server (stopped)" > "$YAD_PIPE"
else
  # Server is stopped - start it
  echo -e "\033[36mdev-with-tray.sh:\033[0m Starting server"
  cd "$PWD"
  NODE_ENV=development DEBUG=libreviews:* node --import tsx/esm bin/www.ts &
  echo \$! > "$PID_FILE"
  # Update tray icon to stop state
  echo "icon:media-playback-stop" > "$YAD_PIPE"
  echo "tooltip:lib.reviews dev server (running)" > "$YAD_PIPE"
fi
EOF
chmod +x "$TOGGLE_SCRIPT"

# Open the named pipe on file descriptor 3 to keep it alive
# This allows the toggle script to write to it and yad to read from it
exec 3<> "$YAD_PIPE"

# Show tray icon with yad in listen mode
# --listen: Accept commands on stdin to update icon/tooltip dynamically
# --image: Initial icon (stop icon, since server starts running)
# --command: Script to run when icon is clicked
yad --notification \
  --listen \
  --image=media-playback-stop \
  --text='lib.reviews dev server (running)' \
  --command="$TOGGLE_SCRIPT" <&3 &
YAD_PID=$!

# Wait for yad to exit (cleanup will be handled by trap)
wait $YAD_PID
