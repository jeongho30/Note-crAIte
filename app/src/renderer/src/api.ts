// 메인 프로세스 호출. 메인은 처리 오류를 "[코드] 메시지"로 보내고, Electron이 앞에 호출 정보를 붙인다.
export class ApiError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

export async function call<T>(method: string, params?: unknown): Promise<T> {
  try {
    return (await window.api.call(method, params)) as T
  } catch (e) {
    const m = /\[(\w+)\] ([\s\S]*)$/.exec((e as Error).message)
    throw m ? new ApiError(m[1], m[2]) : new ApiError('unknown', '예상하지 못한 문제가 생겼어요. 다시 시도해 주세요.')
  }
}
