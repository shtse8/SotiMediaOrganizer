import { FileHashBaseJob } from "./FileHashBaseJob";
import { ExifDate, ExifDateTime, ExifTool } from "exiftool-vendored";
import { Metadata } from "../types";
import { Injectable } from "@tsed/di";

@Injectable()
export class MetadataExtractionJob extends FileHashBaseJob<null, Metadata> {
  private exifTool: ExifTool;

  constructor() {
    super("metadataExtraction", null);
    this.exifTool = new ExifTool();
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
    if (typeof value === "string") return new Date(value);
    if (value instanceof Date) return value;
    if (value instanceof ExifDateTime) return value.toDate();
    if (value instanceof ExifDate) return value.toDate();
    return undefined;
  }
}
