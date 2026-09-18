import { IsEmail, IsNotEmpty, IsUUID, MaxLength } from 'class-validator';

export class CreateUserDto {
  // The Keycloak `sub` of the user this record belongs to (ID-8); users are provisioned in the realm.
  @IsUUID()
  id: string;

  @IsEmail()
  @MaxLength(254)
  email: string;

  @IsNotEmpty()
  @MaxLength(200)
  name: string;
}
