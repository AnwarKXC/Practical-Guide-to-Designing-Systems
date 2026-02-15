const fs = require('fs');
const path = require('path');

const dir = 'e:\\Global Booking System';

// Define the merge order - all sections of the book in sequence
const files = [
  'ebook_front_matter.md',
  'ebook_ch01_02.md',
  'ebook_ch03_04.md',
  'ebook_ch05_06.md',
  'enhanced_ch08.md',
  'enhanced_ch09.md',
  'enhanced_ch10.md',
  'enhanced_ch11.md',
  'enhanced_ch12.md',
  'enhanced_ch13.md',
  'enhanced_ch14.md',
  'enhanced_ch15.md',
  'enhanced_ch16.md',
  'enhanced_ch17.md',
  'enhanced_ch18.md',
  'enhanced_ch19.md',
  'enhanced_ch20.md',
  'enhanced_ch21.md',
  'enhanced_ch22.md',
  'enhanced_ch23.md',
  'enhanced_ch24.md',
  'enhanced_ch25.md',
  'enhanced_ch26.md',
  'enhanced_ch27.md',
  'enhanced_ch28.md',
  'enhanced_ch29.md',
  'enhanced_ch30.md',
  'enhanced_ch31.md',
  'enhanced_ch32.md',
  'enhanced_ch33.md',
  'enhanced_ch34.md',
  'enhanced_ch35.md',
  'enhanced_ch36.md',
  'enhanced_ch37.md',
  'enhanced_ch38.md',
  'enhanced_ch39.md',
  'enhanced_ch40.md',
  'enhanced_ch41.md',
  'enhanced_ch42.md',
  'enhanced_ch43.md',
  'enhanced_ch44.md',
  'enhanced_ch45.md',    // NEW: Production Metrics
  'enhanced_ch46.md',    // NEW: Interview Mode
  'war_stories.md',      // NEW: War Stories appendix
  'ebook_back_matter.md',
];

let merged = '';
let totalLines = 0;

for (const file of files) {
  const filePath = path.join(dir, file);
  if (!fs.existsSync(filePath)) {
    console.error(`WARNING: File not found: ${file}`);
    continue;
  }
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split('\n').length;
  totalLines += lines;
  merged += content;
  // Add separator between files
  if (!content.endsWith('\n')) {
    merged += '\n';
  }
  merged += '\n---\n\n';
  console.log(`  ${file}: ${lines} lines`);
}

const outputPath = path.join(dir, 'Global_Booking_System_Mentorship_Ebook.md');
fs.writeFileSync(outputPath, merged, 'utf8');

const stats = fs.statSync(outputPath);
const sizeMB = (stats.size / (1024 * 1024)).toFixed(2);
const finalLines = merged.split('\n').length;

console.log(`\nMerge complete!`);
console.log(`  Total lines: ${finalLines}`);
console.log(`  File size: ${sizeMB} MB`);
console.log(`  Output: ${outputPath}`);
