import FileList from './FileList.jsx';
import { FileApi } from '../api/endpoints.js';

export default function Recent() {
  return (
    <FileList
      title="Recent"
      emptyText="No recently accessed files. Open or download a file to see it here."
      queryKey={['file-recent']}
      queryFn={() => FileApi.recent()}
    />
  );
}
