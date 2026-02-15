const fs = require('fs');
const path = require('path');

const dir = 'e:\\Global Booking System';

function fixFile(filename, replacements) {
  const filepath = path.join(dir, filename);
  let content = fs.readFileSync(filepath, 'utf8');
  let changeCount = 0;

  for (const [from, to] of replacements) {
    const before = content;
    if (typeof from === 'string') {
      content = content.split(from).join(to);
    } else {
      content = content.replace(from, to);
    }
    if (content !== before) changeCount++;
  }

  fs.writeFileSync(filepath, content, 'utf8');
  console.log(`${filename}: ${changeCount} replacements applied`);
  return changeCount;
}

// === Ch14: JSONB → JSON ===
fixFile('enhanced_ch14.md', [
  ['JSONB', 'JSON'],
]);

// === Ch15: JSONB → JSON ===
fixFile('enhanced_ch15.md', [
  ['JSONB', 'JSON'],
]);

// === Ch21: JSONB → JSON ===
fixFile('enhanced_ch21.md', [
  ['JSONB', 'JSON'],
]);

// === Ch25: JSONB → JSON ===
fixFile('enhanced_ch25.md', [
  ['JSONB', 'JSON'],
]);

// === Ch32: PgBouncer → ProxySQL ===
fixFile('enhanced_ch32.md', [
  ['PgBouncer', 'ProxySQL'],
]);

// === Ch41: TypeORM entity reference → Prisma ===
fixFile('enhanced_ch41.md', [
  ['booking.entity.ts              # TypeORM / database entity',
   'booking.entity.ts              # Prisma model / database entity'],
  ['In TypeORM entities, use the `@Column` decorator to map `camelCase` TypeScript properties to `snake_case` database columns:',
   'In Prisma models, use the `@map` attribute to map `camelCase` TypeScript properties to `snake_case` database columns:'],
  ["import { TypeOrmModule } from '@nestjs/typeorm';",
   "import { PrismaModule } from '../prisma/prisma.module';"],
  ["    TypeOrmModule.forFeature([BookingEntity]),",
   "    PrismaModule,"],
]);

// === Ch26: TypeORM DataSource → Prisma for replication ===
// Ch26 has extensive TypeORM replication code. We need to replace it with Prisma-based approach.
let ch26 = fs.readFileSync(path.join(dir, 'enhanced_ch26.md'), 'utf8');

// Replace the explanation paragraph
ch26 = ch26.replace(
  'If you are using NestJS with TypeORM, the framework has built-in support for read replicas. TypeORM\'s `DataSource` can be configured with a primary (called `master` in TypeORM) and multiple replicas — and it routes queries automatically based on whether they are reads or writes.',
  'If you are using NestJS with Prisma, you can implement read-replica routing using a custom Prisma extension or service layer. Unlike TypeORM, Prisma does not have built-in replication routing, but you can achieve the same result cleanly with a `ReplicaAwarePrismaService` that directs reads to replicas and writes to the primary.'
);

// Replace the section header
ch26 = ch26.replace('### TypeORM DataSource with Replication', '### Prisma with Read-Replica Routing');

// Replace the entire TypeORM config block
const oldTypeOrmConfig = `// src/config/typeorm.config.ts
import { DataSource } from 'typeorm';`;

ch26 = ch26.replace(oldTypeOrmConfig, `// src/config/prisma-replica.service.ts
import { PrismaClient } from '@prisma/client';`);

// Replace references in the code sections and descriptions
ch26 = ch26.split("import { TypeOrmModule } from '@nestjs/typeorm';").join("import { PrismaModule } from '../prisma/prisma.module';");
ch26 = ch26.split("import { AppDataSource } from '../config/typeorm.config';").join("import { ReplicaAwarePrismaService } from '../config/prisma-replica.service';");
ch26 = ch26.split("TypeOrmModule.forRootAsync({").join("PrismaModule.forRootAsync({");
ch26 = ch26.split("exports: [TypeOrmModule],").join("exports: [PrismaModule],");
ch26 = ch26.split("import { InjectRepository } from '@nestjs/typeorm';").join("import { Injectable } from '@nestjs/common';");
ch26 = ch26.split("import { Repository, DataSource } from 'typeorm';").join("import { ReplicaAwarePrismaService } from '../config/prisma-replica.service';");

// Fix the service descriptions
ch26 = ch26.replace(
  'Creates a booking. TypeORM automatically routes this to the master',
  'Creates a booking. The write client routes this to the primary'
);
ch26 = ch26.replace(
  '// TypeORM sees .save() -> routes to master',
  '// Write operations always go to the primary'
);
ch26 = ch26.replace(
  'Reads bookings for a user. TypeORM routes this to a replica',
  'Reads bookings for a user. The read client routes this to a replica'
);
ch26 = ch26.replace(
  '// TypeORM sees .find() -> routes to a slave (round-robin)',
  '// Read operations go to a replica (round-robin)'
);

// Fix the Key Term box
ch26 = ch26.replace(
  /> \*\*Key Term:\*\* \*\*QueryRunner\*\* — In TypeORM.*?read-after-write consistency\./s,
  '> **Key Term:** **Replica-Aware Service** — In Prisma, since there is no built-in replica routing, you create a service that holds two `PrismaClient` instances: one connected to the primary and one connected to a replica. Your application code calls `prisma.read.booking.findMany()` for reads and `prisma.write.booking.create()` for writes. For read-after-write consistency, simply use the write client for the follow-up read.'
);

// Fix the summary table row
ch26 = ch26.replace(
  /\| \*\*NestJS \/ TypeORM\*\* \| TypeORM supports replication.*?\|/,
  '| **NestJS / Prisma** | Prisma does not have built-in replication support, but you can create a `ReplicaAwarePrismaService` with separate read/write clients. Use the write client to force reads to the primary when read-after-write consistency is needed. |'
);

fs.writeFileSync(path.join(dir, 'enhanced_ch26.md'), ch26, 'utf8');
console.log('enhanced_ch26.md: TypeORM → Prisma replication replacements applied');

console.log('\nAll remaining fixes applied.');
