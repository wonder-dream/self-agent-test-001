export class BudgetExceeded extends Error {
  constructor(message = "今日额度已用完") {
    super(message);
    this.name = "BudgetExceeded";
  }
}

export class NeedKey extends Error {
  constructor() {
    super("还没有 DeepSeek API Key");
    this.name = "NeedKey";
  }
}

export class ModelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelError";
  }
}

export class StoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StoreError";
  }
}
