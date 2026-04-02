import { IsNotEmpty, IsString, MaxLength } from "class-validator";

export class RequestIdParamDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  requestId!: string;
}
