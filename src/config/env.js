/**
 * 集中读取与校验环境变量
 * 其他模块只从这里拿配置，不直接读 process.env
 */

function required(key, hint) {
  const v = process.env[key];
  if (!v) {
    throw new Error(`❌ 缺少环境变量 ${key}。${hint || ''}（参考 .env.example）`);
  }
  return v;
}

function optional(key, defaultValue) {
  const v = process.env[key];
  return v === undefined || v === '' ? defaultValue : v;
}

export const config = {
  port: Number(optional('PORT', '3000')),
  nodeEnv: optional('NODE_ENV', 'development'),
  isProd: optional('NODE_ENV', 'development') === 'production',

  sessionSecret: optional('SESSION_SECRET', 'dev-only-secret-change-me'),

  // 双账号
  users: {
    a: {
      username: required('USER_A_USERNAME', '请配置 USER_A_USERNAME'),
      displayName: optional('USER_A_DISPLAY_NAME', 'User A'),
      passwordHash: required('USER_A_PASSWORD_HASH', '请用 bcryptjs 生成 USER_A_PASSWORD_HASH'),
    },
    b: {
      username: required('USER_B_USERNAME', '请配置 USER_B_USERNAME'),
      displayName: optional('USER_B_DISPLAY_NAME', 'User B'),
      passwordHash: required('USER_B_PASSWORD_HASH', '请用 bcryptjs 生成 USER_B_PASSWORD_HASH'),
    },
  },

  // 数据存储
  dbType: optional('DB_TYPE', 'json'), // 'json' | 'supabase'
  supabase: {
    url: optional('SUPABASE_URL', ''),
    key: optional('SUPABASE_KEY', ''),
    dbUrl: optional('SUPABASE_DB_URL', ''),
  },
};
