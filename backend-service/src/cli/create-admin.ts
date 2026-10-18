import { createInterface } from 'node:readline/promises'
import { stdin, stdout } from 'node:process'

import { hashPassword, validatePassword } from '../auth/auth-service.js'
import { createPool } from '../db/pool.js'
import { migrateDatabase } from '../db/migrate.js'

async function readHidden(question: string) {
  const input = stdin as NodeJS.ReadStream
  if (!input.isTTY) throw new Error('La creación inicial de ADMIN requiere una terminal interactiva para no mostrar la contraseña.')

  stdout.write(question)
  input.setRawMode(true)
  input.resume()

  return new Promise<string>((resolve, reject) => {
    let value = ''
    const finish = (error?: Error) => {
      input.off('data', onData)
      input.setRawMode(false)
      stdout.write('\n')
      if (error) reject(error)
      else resolve(value)
    }
    const onData = (chunk: Buffer | string) => {
      for (const character of chunk.toString()) {
        if (character === '\u0003') return finish(new Error('Creación cancelada.'))
        if (character === '\r' || character === '\n') return finish()
        if (character === '\u007f' || character === '\b') {
          value = Array.from(value).slice(0, -1).join('')
          continue
        }
        value += character
      }
    }
    input.on('data', onData)
  })
}

async function main() {
  const prompt = createInterface({ input: stdin, output: stdout })
  const name = (await prompt.question('Nombre visible de la cuenta ADMIN: ')).trim()
  const email = (await prompt.question('Correo de acceso ADMIN: ')).trim().toLowerCase()
  prompt.close()

  if (!name) throw new Error('El nombre es obligatorio.')
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)) throw new Error('Indica un correo electrónico válido.')

  const pool = createPool()
  try {
    await migrateDatabase(pool)
    const existing = await pool.query('SELECT 1 FROM administradores LIMIT 1')
    if (existing.rowCount) throw new Error('Ya existe una cuenta ADMIN; no se creará otra.')

    const password = await readHidden('Contraseña ADMIN (mínimo 12 caracteres): ')
    const confirmation = await readHidden('Repite la contraseña: ')
    validatePassword(password)
    if (password !== confirmation) throw new Error('Las contraseñas no coinciden.')

    const passwordHash = await hashPassword(password)
    await pool.query(`
      INSERT INTO administradores (nombre, fecha_inicio, correo_electronico, password_hash)
      VALUES ($1, CURRENT_DATE, $2, $3)
    `, [name, email, passwordHash])
    console.log('Cuenta ADMIN creada. Guarda sus credenciales en el gestor de secretos del equipo.')
  } finally {
    await pool.end()
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'No se pudo crear la cuenta ADMIN.')
  process.exitCode = 1
})
