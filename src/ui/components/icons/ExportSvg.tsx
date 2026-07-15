export default ({ fill, className }: { fill?: string; className?: string }) => {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      width="24"
      height="24"
      xmlns="http://www.w3.org/2000/svg">
      <path
        d="M5 20h14v-2H5v2zm7-18L5.33 9h3.17v6h5v-6h3.17L12 2z"
        fill={fill}
      />
    </svg>
  )
}
