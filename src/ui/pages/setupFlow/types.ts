/**
 * setupFlow — 引导流程共享类型
 */

/** 引导流程的步骤标识（顺序：welcome → setWorkdir → setup） */
export type SetupStep = 'welcome' | 'setWorkdir' | 'setup'
