// 测试用 node:sqlite 垫片：以 sql.js（WASM SQLite）模拟 DatabaseSync，仅供本地集成测试
import initSqlJs from 'sql.js'
import fs from 'node:fs'

const SQL = await initSqlJs({ locateFile: (f) => `node_modules/sql.js/dist/${f}` })

export class DatabaseSync {
  constructor(_path) {
    // 测试使用内存库；PUBMON_TEST_DB 指向既有库文件时加载其内容（模拟旧库迁移）
    const file = process.env.PUBMON_TEST_DB
    this.db = file && fs.existsSync(file) ? new SQL.Database(fs.readFileSync(file)) : new SQL.Database()
  }
  exec(sql) { this.db.exec(sql) }
  prepare(sql) {
    const db = this.db
    return {
      run(...params) {
        db.run(sql, params)
        const changes = db.getRowsModified()
        const lastInsertRowid = db.exec('SELECT last_insert_rowid() AS id')[0].values[0][0]
        return { changes, lastInsertRowid }
      },
      get(...params) {
        const rows = db.exec(sql, params)
        if (!rows.length || !rows[0].values.length) return undefined
        return Object.fromEntries(rows[0].columns.map((c, i) => [c, rows[0].values[0][i]]))
      },
      all(...params) {
        const rows = db.exec(sql, params)
        if (!rows.length) return []
        return rows[0].values.map((v) => Object.fromEntries(rows[0].columns.map((c, i) => [c, v[i]])))
      }
    }
  }
}
