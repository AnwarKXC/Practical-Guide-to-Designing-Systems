const fs = require('fs');
const path = require('path');

const filePath = path.join('e:\\Global Booking System', 'ebook_front_matter.md');
let content = fs.readFileSync(filePath, 'utf8');

// Update the Part/Chapter count
content = content.replace(
  'The book is organized into **11 Parts** with **44 Chapters**.',
  'The book is organized into **13 Parts** with **46 Chapters**.'
);

// Add new Parts after Part 10
const oldPart10End = `  - Chapter 44: Glossary & Learning Resources — Your Reference Shelf
\`\`\``;

const newPart10End = `  - Chapter 44: Glossary & Learning Resources — Your Reference Shelf

Part 11: Real Production Metrics (Ch 45)
  - Chapter 45: Production Metrics — Dashboards, Alerts, SLO Math & Cost Per Booking

Part 12: Interview Mode (Ch 46)
  - Chapter 46: Interview Mode — Presenting This System in 45 Minutes
\`\`\``;

content = content.replace(oldPart10End, newPart10End);

fs.writeFileSync(filePath, content, 'utf8');
console.log('TOC updated successfully');
