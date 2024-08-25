import { FileHashBaseJob } from "./FileHashBaseJob";
import { ExifDate, ExifDateTime, ExifTool } from "exiftool-vendored";
import { Metadata } from "../types";
import { Injectable, ProviderScope } from "@tsed/di";

@Injectable({
  scope: ProviderScope.SINGLETON,
})
export class MetadataExtractionJob extends FileHashBaseJob<null, Metadata> {
  constructor(private exifTool: ExifTool) {
    super("metadataExtraction", null);
  }

  protected async processFile(filePath: string): Promise<Metadata> {
    const tags = await this.exifTool.read(filePath);
    return {
      imageDate:
        this.toDate(tags.DateTimeOriginal) ?? this.toDate(tags.MediaCreateDate),
      width: tags.ImageWidth || 0,
      height: tags.ImageHeight || 0,
      gpsLatitude: tags.GPSLatitude,
      gpsLongitude: tags.GPSLongitude,
      cameraModel: tags.Model,
    };
  }

  private toDate(
    value: string | ExifDateTime | ExifDate | undefined,
  ): Date | undefined {
    if (!value) return undefined;
    if (typeof value === "string") {
      const date = new Date(value);
      if (!isNaN(date.getTime())) return date;
      return undefined;
    }
    if (value instanceof Date) return value;
    if (value instanceof ExifDateTime) return value.toDate();
    if (value instanceof ExifDate) return value.toDate();
    return undefined;
  }
}
