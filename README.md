# File Deduplication Tool

Desktop application for detecting and copying unique files from multiple source folders to a destination folder.

## Prerequisites

- Node.js (v18 or higher) - Download from [nodejs.org](https://nodejs.org/)

## Installation

1. Install dependencies:
   ```bash
   npm install
   ```

## Running the Application

```bash
npm start
```

## Usage

1. Click "Add Source Folder" to select one or more source folders
2. Click "Select Destination Folder" to choose where unique files will be copied
3. Click "Start" to begin the deduplication process
4. Use "Pause" and "Resume" to control the process
5. Monitor progress in the status section

## Features

- Recursive folder scanning
- SHA-256 content hashing for duplicate detection
- Pause/Resume functionality
- Real-time progress tracking
- Handles file name conflicts automatically

