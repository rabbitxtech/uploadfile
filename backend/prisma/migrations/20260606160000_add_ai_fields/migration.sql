-- K1/K4: OCR text and semantic embedding for files.
ALTER TABLE "File" ADD COLUMN "ocrText" TEXT;
ALTER TABLE "File" ADD COLUMN "embedding" TEXT;
