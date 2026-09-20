import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // كل ملف يفتح قاعدة بيانات في الذاكرة خاصة به، فلا حالة مشتركة تُعاد
    // استخدامها بين الملفات — وعزل العمليات يكلّف أكثر مما يفيد هنا.
    isolate: false,
    fileParallelism: false,
  },
});
