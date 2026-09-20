import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // الاختبارات تفتح قواعد بيانات مؤقتة وتحذفها، فالتشغيل المتوازي آمن،
    // لكن التسلسل يجعل قراءة السجل أوضح عند الفشل.
    fileParallelism: false,
  },
});
