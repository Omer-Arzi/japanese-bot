import * as fs from "fs";
import * as path from "path";
import { PDFParse } from "pdf-parse";

async function main() {
  const filePath = path.join(process.cwd(), "docs", "חוברת קורס מתחילים.pdf");

  if (!fs.existsSync(filePath)) {
    console.error("PDF not found:", filePath);
    process.exit(1);
  }

  const buffer = fs.readFileSync(filePath);
  const parser = new PDFParse({ data: buffer });
  const result = await parser.getText();

  console.log("Pages:", result.total);
  console.log("Text length:", result.text.length);
  console.log("\nPreview (first 2000 chars):");
  console.log(result.text.slice(0, 2000));

  const dataDir = path.join(process.cwd(), "data");
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir);
  }

  const outPath = path.join(dataDir, "beginner-course-workbook.txt");
  fs.writeFileSync(outPath, result.text, "utf-8");
  console.log("\nSaved to:", outPath);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
