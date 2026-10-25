import assert from 'node:assert/strict'
import { win32 } from 'node:path'

/** Go C-shared DLLs retain runtime threads after export inspection. Prevent
 * Koffi's exit cleanup from unloading their code while those threads still run.
 * GET_MODULE_HANDLE_EX_FLAG_PIN lasts only for this verification process.
 */
export function loadLibraryForValidation(koffi, filename, platform = process.platform) {
  const library = koffi.load(filename)
  if (platform === 'win32') {
    assert.ok(win32.isAbsolute(filename), 'Native validation requires an absolute library path')
    const kernel32 = koffi.load('kernel32.dll')
    const pin = kernel32.func('GetModuleHandleExW', 'bool', [
      'uint32', 'str16', koffi.out(koffi.pointer('void *'))
    ])
    const handle = [null]
    assert.ok(pin(1, win32.normalize(filename), handle), 'Cannot retain verified native library until process exit')
    assert.ok(handle[0] !== null, 'Native library pin returned no module handle')
  }
  return library
}
