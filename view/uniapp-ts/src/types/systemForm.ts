export interface SystemFormChoice {
  val?: string;
  value?: string;
  label?: string;
  [key: string]: unknown;
}

export interface SystemFormComponent {
  id?: string | number;
  name: string;
  value: unknown;
  titleConfig?: { value?: string };
  tipConfig?: { value?: string };
  titleShow?: { val?: boolean };
  wordsConfig?: { list?: SystemFormChoice[] };
  defaultValConfig?: { value?: string };
  valConfig?: { tabVal?: number };
  numConfig?: { val?: number };
  [key: string]: unknown;
}

export interface SystemFormInfo {
  id: number;
  name: string;
  value: SystemFormComponent[];
}
