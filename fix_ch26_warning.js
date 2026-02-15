const fs = require('fs');

let ch26 = fs.readFileSync('e:\\Global Booking System\\enhanced_ch26.md', 'utf8');

const oldWarning = `> **What If You Skip This?** TypeORM's default routing is coarse-grained: all queries through \`.find()\`, \`.findOne()\`, and \`.createQueryBuilder()\` go to a slave, while \`.save()\`, \`.update()\`, \`.delete()\`, and \`.remove()\` go to master. But it does not know about *causality* — it cannot tell that your \`.findOne()\` needs to see data from a \`.save()\` that happened 50 milliseconds ago. Without explicit master routing for read-after-write scenarios, your users will occasionally create a booking and then see an empty "my bookings" page.`;

const newWarning = `> **What If You Skip This?** If you naively send all reads to a replica and all writes to the primary, the system cannot tell that your read needs to see data from a write that happened 50 milliseconds ago. Replication lag — even as low as 100ms — means your users will occasionally create a booking and then see an empty "my bookings" page. Without explicit primary routing for read-after-write scenarios, you will introduce this subtle, intermittent bug that is extremely hard to reproduce and debug.`;

ch26 = ch26.replace(oldWarning, newWarning);
fs.writeFileSync('e:\\Global Booking System\\enhanced_ch26.md', ch26, 'utf8');
console.log('Ch26 warning box fixed');
