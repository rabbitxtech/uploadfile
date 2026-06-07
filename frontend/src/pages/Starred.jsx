import FileList from './FileList.jsx';
import { FileApi } from '../api/endpoints.js';

export default function Starred() {
  return (
    <FileList
      title="Starred"
      emptyText="No starred files yet. Click the star icon on any file to bookmark it."
      queryKey={['file-starred']}
      queryFn={() => FileApi.starred()}
    />
  );
}
