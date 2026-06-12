-- Task5 #9 — HLS adaptive-streaming renditions flag.
ALTER TABLE "File" ADD COLUMN "hlsReady" BOOLEAN NOT NULL DEFAULT false;
