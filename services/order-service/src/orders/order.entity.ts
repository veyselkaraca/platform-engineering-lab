import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('orders')
export class Order {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId: string;

  // pg returns NUMERIC as string; the API exposes a number.
  @Column({ type: 'numeric', precision: 12, scale: 2, transformer: { to: (v: number) => v, from: (v: string) => Number(v) } })
  amount: number;

  @Column()
  description: string;

  @Column({ default: 'CREATED' })
  status: string;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
