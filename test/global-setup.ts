import { execSync } from 'child_process';
import { TEST_DATABASE_URL } from './test-env';

export default function globalSetup(): void {
  execSync('npx prisma migrate deploy', {
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
  });
}
