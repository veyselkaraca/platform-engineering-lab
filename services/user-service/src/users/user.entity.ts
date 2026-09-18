import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';

@Entity('users')
export class User {
  @PrimaryColumn('uuid')
  id: string;

  @Column({ unique: true })
  email: string;

  @Column()
  name: string;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
