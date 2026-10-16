
# Aspirant

A lightweight web utility workspace built with HTML, CSS, JavaScript, and Node.js.

## Features

- Overview with backend status and local latency.
- Web Scraper for public HTML pages.
- Direct URL downloader for accessible files.
- Scraping history with search and deletion.
- JSON formatter, minifier, validator, and key sorter.
- WhatsApp Direct Chat link generator.
- Base64 encoder and decoder.
- SHA-256 hashing.
- QR code generation through an external service.
- API Tester for common HTTP methods.
- Browser-based image adjustments and export.

## Requirements

- Node.js 20 or newer.
- npm.
- Internet access for package installation and online tools.

## Project Structure

```text
Aspirant/
├── package.json
├── server.js
├── README.md
└── public/
    └── index.html
```

## Installation

Open a terminal in the project directory and install dependencies:

```bash
npm install
```

## Run

Start the application:

```bash
npm start
```

Open this address in your browser:

```text
http://127.0.0.1:3000
```

Keep the Node.js server running while using the application.

## Notes

- Backend-dependent tools require the server to be running.
- Scraping works only with accessible public HTML pages.
- The downloader currently handles direct URLs; it is not a universal video extractor.
- QR generation uses an external service.
- Image editing runs in the browser. AI image processing is not included.
- API requests should only target services you are authorized to access.
- The history currently lives in server memory and resets when the server restarts.
- Do not expose the development server publicly without additional security controls.

## License

Personal and educational use.
