const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');

const prisma = new PrismaClient();

const QUALIFICATIONS = ['PARA', 'ECA', 'TECH', 'NQP1'];
const AREAS = ['Luton', 'Stevenage', 'Mid Hertfordshire'];
const VEHICLES = ['DSA 1', 'DSA 2', 'DSA 3'];

async function main() {
  const adminEmail = process.env.SEED_ADMIN_EMAIL || 'darren.teale@medicalemergencysolutions.co.uk';
  const adminPassword = process.env.SEED_ADMIN_PASSWORD || 'ChangeMe123!';

  const adminHash = await bcrypt.hash(adminPassword, 10);
  const admin = await prisma.user.upsert({
    where: { email: adminEmail },
    update: {},
    create: {
      name: 'Darren Smith',
      email: adminEmail,
      passwordHash: adminHash,
      role: 'ADMIN',
      qualification: 'PARA',
    },
  });

  const staffNames = [
    'Leon-James Gibson', 'Bradley Pollard', 'Rachael Wallace', 'Kieran Gunn',
    'Laura Sims', 'David Nobbs', 'Glen Gilbert', 'Emily Garrett',
    'Kamil Lokicijewski', 'Lewis Chowney', 'Robert Smith', 'Warren Downie',
    'Joseph Allen', 'Igor Polok', 'Samuel Smyth', 'Daniel Stanton',
  ];

  const staff = [];
  for (let i = 0; i < staffNames.length; i++) {
    const name = staffNames[i];
    const email = `${name.toLowerCase().replace(/[^a-z]+/g, '.')}@dynamo-demo.local`;
    const hash = await bcrypt.hash('Password123!', 10);
    const user = await prisma.user.upsert({
      where: { email },
      update: {},
      create: {
        name,
        email,
        passwordHash: hash,
        role: 'STAFF',
        qualification: QUALIFICATIONS[i % QUALIFICATIONS.length],
      },
    });
    staff.push(user);
  }

  const existingShifts = await prisma.shift.count();
  if (existingShifts === 0) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    let refCounter = 1;
    for (let day = 0; day < 7; day++) {
      const date = new Date(today);
      date.setDate(date.getDate() + day);

      const periods = [
        [10, 0, 22, 0],
        [10, 30, 22, 30],
        [19, 0, 5, 0],
        [19, 30, 5, 30],
      ];

      for (let p = 0; p < periods.length; p++) {
        const [sh, sm, eh, em] = periods[p];
        const start = new Date(date);
        start.setHours(sh, sm, 0, 0);
        const end = new Date(date);
        end.setHours(eh, em, 0, 0);
        if (eh < sh) end.setDate(end.getDate() + 1);

        const c1 = staff[(day + p) % staff.length];
        const c2 = staff[(day + p + 1) % staff.length];

        await prisma.shift.create({
          data: {
            ref: `BKE${String(refCounter++).padStart(3, '0')}`,
            date,
            startTime: start,
            endTime: end,
            type: 'CORE',
            status: 'CONFIRMED',
            vehicle: VEHICLES[p % VEHICLES.length],
            area: AREAS[(day + p) % AREAS.length],
            crew: {
              create: [
                { position: 1, userId: c1.id, roleLabel: c1.qualification },
                { position: 2, userId: c2.id, roleLabel: c2.qualification },
              ],
            },
          },
        });
      }
    }
  }

  console.log('Seed complete.');
  console.log(`Admin login: ${adminEmail} / ${adminPassword}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
