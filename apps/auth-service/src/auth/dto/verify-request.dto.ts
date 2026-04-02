import { Transform } from "class-transformer";
import { ArrayMaxSize, IsArray, IsIn, IsNotEmpty, IsOptional, IsString, MaxLength } from "class-validator";
import { SUPPORTED_SCOPES, type SupportedScope } from "@cqut/shared";

function trimString(value: unknown) {
  return typeof value === "string" ? value.trim() : value;
}

export class VerifyRequestDto {
  @Transform(({ value }) => trimString(value))
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  account!: string;

  @Transform(({ value }) => trimString(value))
  @IsString()
  @IsNotEmpty()
  @MaxLength(256)
  password!: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(8)
  @IsString({ each: true })
  @IsIn(SUPPORTED_SCOPES, { each: true })
  scope?: SupportedScope[];
}
