declare module 'qrcode-terminal/vendor/QRCode' {
  class QRCode {
    constructor(typeNumber: number, errorCorrectLevel: number);
    addData(data: string): void;
    make(): void;
    getModuleCount(): number;
    isDark(row: number, column: number): boolean;
  }
  export = QRCode;
}

declare module 'qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel' {
  const levels: { L: number; M: number; Q: number; H: number };
  export = levels;
}
