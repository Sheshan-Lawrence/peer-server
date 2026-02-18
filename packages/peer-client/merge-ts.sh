#!/usr/bin/env bash

SOURCE_DIR="$1"
OUTPUT_FILE="$2"

if [ -z "$SOURCE_DIR" ] || [ -z "$OUTPUT_FILE" ]; then
  echo "Usage: $0 <source_directory> <output_file>"
  exit 1
fi

> "$OUTPUT_FILE"

find "$SOURCE_DIR" \
  -type d \( -name "node_modules" -o -name ".git" -o -name "dist" -o -name "build" \) -prune -o \
  -type f -name "*.ts" -print | while read -r file; do
    echo "===== FILE: $file =====" >> "$OUTPUT_FILE"
    cat "$file" >> "$OUTPUT_FILE"
    echo -e "\n\n" >> "$OUTPUT_FILE"
done

echo "Done. All .ts files merged into $OUTPUT_FILE"
