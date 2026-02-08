import { IsString, IsArray, IsOptional, IsBoolean, IsUrl } from 'class-validator';

export class CreateWebhookDto {
  @IsUrl()
  url!: string;

  @IsArray()
  @IsString({ each: true })
  events!: string[];
}

export class UpdateWebhookDto {
  @IsOptional()
  @IsUrl()
  url?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  events?: string[];

  @IsOptional()
  @IsBoolean()
  active?: boolean;
}
