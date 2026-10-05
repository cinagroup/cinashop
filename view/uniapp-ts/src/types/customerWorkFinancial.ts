export * from '../../../common/customerWorkFinancial';
import type {CustomerFinancialResult} from '../../../common/customerWorkFinancial';
export interface CustomerFinancialOperationState{result:CustomerFinancialResult|null;unknown:boolean;checked:boolean;error:string}
