import { offlineReturnResponse } from '../../common/offlineReturn';
export const onRequest = ({request}:{request:Request}) => offlineReturnResponse(request,'h5');
